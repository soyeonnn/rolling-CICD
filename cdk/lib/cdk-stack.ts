
import cdk = require('@aws-cdk/core');
import ec2 = require('@aws-cdk/aws-ec2');
import ecr = require('@aws-cdk/aws-ecr');
import eks = require('@aws-cdk/aws-eks');
import iam = require('@aws-cdk/aws-iam');
import codebuild = require('@aws-cdk/aws-codebuild');
import codecommit = require('@aws-cdk/aws-codecommit');
import targets = require('@aws-cdk/aws-events-targets');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import codepipeline_actions = require('@aws-cdk/aws-codepipeline-actions');



export class CdkStackALBEksBg extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * Create a new VPC with single NAT Gateway
     */
    const vpc = new ec2.Vpc(this, 'NewVPC', {
      cidr: '10.0.0.0/16',
      natGateways: 1
    });

    const clusterAdmin = new iam.Role(this, 'AdminRole', {
      assumedBy: new iam.AccountRootPrincipal()
    });

    const controlPlaneSecurityGroup = new ec2.SecurityGroup(this, 'SecurityGroup', {
      vpc,
      allowAllOutbound: true
    });
    
    controlPlaneSecurityGroup.addIngressRule(
        ec2.Peer.anyIpv4(),
        ec2.Port.tcp(80),
        "Allow all inbound traffic by default",
    );

    const cluster = new eks.Cluster(this, 'Cluster', {
      version: eks.KubernetesVersion.V1_21,
      securityGroup: controlPlaneSecurityGroup,
      vpc,
      defaultCapacity: 2,
      mastersRole: clusterAdmin,
      outputClusterName: true,
    });
    
    

    const ecrRepoFront = new ecr.Repository(this, 'ecrRepoFront');

    const ecrRepoBack = new ecr.Repository(this, 'ecrRepoBack');

    const repository = new codecommit.Repository(this, 'CodeCommitRepo', {
      repositoryName: `${this.stackName}-repo`
    });


    // CODEBUILD - project
    const project = new codebuild.Project(this, 'MyProject', {
      projectName: `${this.stackName}`,
      source: codebuild.Source.codeCommit({ repository: repository }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromAsset(this, 'CustomImage', {
          directory: '../dockerAssets.d',
        }),
        privileged: true
      },
      environmentVariables: {
        'CLUSTER_NAME': {
          value: `${cluster.clusterName}`
        },
        'ECR_REPO_URI_FRONT': {
          value: `${ecrRepoFront.repositoryUri}`
        },
        'ECR_REPO_URI_BACK': {
            value: `${ecrRepoBack.repositoryUri}`
        },
        'DOCKER_USERNAME': {
          value: process.env.DOCKER_USERNAME
        },
        'DOCKER_PASSWORD': {
          value: process.env.DOCKER_PASSWORD
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}',
              'export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output=text)',
              '/usr/local/bin/entrypoint.sh',
              'echo Logging in to Amazon ECR',
              'docker login --username ${DOCKER_USERNAME} --password ${DOCKER_PASSWORD}',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com'
            ]
          },
          build: {
            commands: [
              'cd CICD-rolling-front',
              `docker build -t $ECR_REPO_URI_FRONT:$TAG .`,
              'docker push $ECR_REPO_URI_FRONT:$TAG',
              'cd ../CICD-rolling-back',
              `docker build -t $ECR_REPO_URI_BACK:$TAG .`,
              'docker push $ECR_REPO_URI_BACK:$TAG'
            ]
          },
          post_build: {
            commands: [
              'kubectl get nodes -n rolling-alb',
              'kubectl get deploy -n rolling-alb',
              'kubectl get svc -n rolling-alb',
              "isDeployed=$(kubectl get deploy -n rolling-alb -o json | jq '.items[0]')",
              "deploy8080=$(kubectl get svc -n rolling-alb -o wide | grep 8080: | tr ' ' '\n' | grep app= | sed 's/app=//g')",
              "echo $isDeployed $deploy8080",
              "if [[ \"$isDeployed\" == \"null\" ]]; then kubectl apply -f ./db.yaml && kubectl apply -f ./back.yaml && kubectl apply -f ../CICD-rolling-front/front.yaml; else kubectl set image deployment rolling-server rolling-server=$ECR_REPO_URI_BACK:$TAG && kubectl set image deployment rolling-front rolling-front=$ECR_REPO_URI_FRONT:$TAG; fi",
              'kubectl get deploy -n rolling-alb',
              'kubectl get svc -n rolling-alb'
            ]
          }
        }
      })
    })
    

    // PIPELINE

    const sourceOutput = new codepipeline.Artifact();

    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'CodeCommit',
      repository: repository,
      output: sourceOutput,
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: project,
      input: sourceOutput,
      outputs: [new codepipeline.Artifact()], // optional
    });
    
    const buildAction2 = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: project,
      input: sourceOutput,
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve',
    });


    new codepipeline.Pipeline(this, 'MyPipelineFront', {
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'BuildAndDeploy',
          actions: [buildAction],
        },
        {
          stageName: 'ApproveSwapBG',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'SwapBG',
          actions: [buildAction2],
        },
      ],
    });
    

    repository.onCommit('OnCommit', {
      target: new targets.CodeBuildProject(project)
    });
    
    ecrRepoFront.grantPullPush(project.role!)
    cluster.awsAuth.addMastersRole(project.role!)
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`${cluster.clusterArn}`],
    }))


    ecrRepoBack.grantPullPush(project.role!)
    cluster.awsAuth.addMastersRole(project.role!)
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: ['eks:DescribeCluster'],
      resources: [`${cluster.clusterArn}`],
    }))


    new cdk.CfnOutput(this, 'CodeCommitRepoNameFront', { value: `${repository.repositoryName}` })
    new cdk.CfnOutput(this, 'CodeCommitRepoArnFront', { value: `${repository.repositoryArn}` })
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlSshFront', { value: `${repository.repositoryCloneUrlSsh}` })
    new cdk.CfnOutput(this, 'CodeCommitCloneUrlHttpFront', { value: `${repository.repositoryCloneUrlHttp}` })

  }
}